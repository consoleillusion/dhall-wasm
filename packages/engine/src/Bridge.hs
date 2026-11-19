{-# LANGUAGE JavaScriptFFI #-}
{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE RecordWildCards #-}
{-# LANGUAGE ScopedTypeVariables #-}

-- | The Dhall WebAssembly engine bridge.
--
-- JavaScript calls the three exports with a JSON request and a resolver
-- callback.  The resolver is invoked through JSFFI whenever Dhall encounters
-- an import, so hosts (Node, browsers, tests) control import resolution.
module Main (main, evaluate, typeCheck, describeType) where

import Codec.CBOR.Encoding
  ( Encoding
  , encodeBool
  , encodeDouble
  , encodeInteger
  , encodeListLen
  , encodeMapLen
  , encodeNull
  , encodeString
  )
import qualified Codec.CBOR.Write as CBOR
import Control.Exception (Exception, SomeException, throwIO, try, fromException)
import Control.Monad (unless, when)
import Data.Aeson
  ( FromJSON (..)
  , ToJSON (toJSON)
  , Value (..)
  , eitherDecodeStrict
  , encode
  , object
  , parseJSON
  , withObject
  , (.=)
  , (.:?)
  )
import qualified Data.Aeson as Aeson
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KeyMap
import qualified Data.ByteString as BS
import qualified Data.ByteString.Lazy as LBS
import Data.Foldable (toList)
import Data.List (sortOn)
import qualified Data.Map.Strict as M
import Data.Maybe (fromMaybe)
import Data.Scientific (floatingOrInteger)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Data.Void (Void, absurd)
import Data.Word (Word8)
import Numeric (showHex)
import Dhall.Core
  ( Chunks (..)
  , DhallDouble (..)
  , Expr (..)
  , FieldSelection (..)
  , Import (..)
  , ImportHashed (..)
  , ImportMode (..)
  , ImportType (..)
  , RecordField (..)
  )
import qualified Dhall.Core as Core
import Dhall.Import (hashExpressionToCode)
import qualified Dhall.Map as DhallMap
import qualified Dhall.Parser as Parser
import Dhall.Src (Src)
import qualified Dhall.TypeCheck as TypeCheck
import GHC.Wasm.Prim (JSVal, JSString (..), fromJSString, toJSString)
import System.FilePath (takeDirectory)

-- | A structured diagnostic that maps directly onto core's @DhallDiagnostic@.
data BridgeError = BridgeError
  { errorKind :: Text
  , errorMessage :: Text
  , errorSource :: Maybe Text
  } deriving (Show)

instance Exception BridgeError

bridgeError :: Text -> Text -> BridgeError
bridgeError kind message = BridgeError kind message Nothing

data Request = Request
  { requestOp :: Text
  , requestSource :: Text
  , requestFormat :: Text
  , requestSourcePath :: Text
  , requestVariables :: M.Map Text Text
  }

instance FromJSON Request where
  parseJSON = withObject "Dhall request" $ \o -> do
    op <- o .:? "op" >>= pure . fromMaybe "evaluate"
    source <- o .:? "source" >>= pure . fromMaybe ""
    format <- o .:? "format" >>= pure . fromMaybe "json"
    path <- o .:? "sourcePath" >>= pure . fromMaybe "source"
    variables <- o .:? "variables" >>= pure . fromMaybe M.empty
    pure (Request op source format path variables)

data ResolverResponse = ResolverResponse
  { resolverOk :: Bool
  , resolverText :: Text
  , resolverSource :: Text
  , resolverErrorKind :: Text
  , resolverErrorMessage :: Text
  }

instance FromJSON ResolverResponse where
  parseJSON = withObject "Import resolution" $ \o -> do
    ok <- fromMaybe False <$> o .:? "ok"
    text <- fromMaybe "" <$> o .:? "text"
    source <- fromMaybe "" <$> o .:? "source"
    err <- fromMaybe (object []) <$> o .:? "error"
    let errorField key fallback = case err of
          Object fields -> case KeyMap.lookup key fields of
            Just (String value) -> value
            _ -> fallback
          _ -> fallback
    pure (ResolverResponse
      ok
      text
      source
      (errorField "kind" "import")
      (errorField "message" "Import resolution failed"))

main :: IO ()
main = pure ()

foreign import javascript safe "$1($2)"
  jsResolveImport :: JSVal -> JSString -> IO JSString

-- | Evaluate a Dhall expression and return a JSON-encoded result envelope.
foreign export javascript "evaluate"
  evaluate :: JSVal -> JSString -> IO JSString

-- | Type-check a Dhall expression and return its inferred type.
foreign export javascript "typeCheck"
  typeCheck :: JSVal -> JSString -> IO JSString

-- | Describe a Dhall type expression as a portable JSON schema.
foreign export javascript "describeType"
  describeType :: JSVal -> JSString -> IO JSString

evaluate :: JSVal -> JSString -> IO JSString
evaluate resolver raw = runBridge raw $ \Request {..} -> do
  normalized <- normalizeRequest resolver requestSourcePath requestVariables requestSource
  case requestFormat of
    "dhall" -> pure (toJSON (Core.pretty normalized))
    _ -> case dhallToValue normalized of
      Left e -> throwIO (bridgeError "evaluation" e)
      Right value
        | requestFormat == "cbor" -> pure (toJSON (toCborHex value))
        | otherwise -> pure value

typeCheck :: JSVal -> JSString -> IO JSString
typeCheck resolver raw = runBridge raw $ \Request {..} -> do
  normalized <- normalizeRequest resolver requestSourcePath requestVariables requestSource
  case TypeCheck.typeOf normalized of
    Left e -> throwIO (bridgeError "typecheck" (renderTypeError e))
    Right t -> pure (toJSON (Core.pretty (Core.denote t)))

describeType :: JSVal -> JSString -> IO JSString
describeType resolver raw = runBridge raw $ \Request {..} -> do
  normalized <- normalizeRequest resolver requestSourcePath requestVariables requestSource
  case TypeCheck.typeOf normalized of
    Left e -> throwIO (bridgeError "typecheck" (renderTypeError e))
    Right inferred
      | Core.normalize (Core.denote inferred) == (Core.Const Core.Type :: Expr Void Void) ->
          describeSchema normalized
      | otherwise -> throwIO (bridgeError "typecheck" "Expected a Dhall type expression")

runBridge :: JSString -> (Request -> IO Value) -> IO JSString
runBridge raw action = do
  outcome <- try $ do
    request <- case eitherDecodeStrict (TE.encodeUtf8 (T.pack (fromJSString raw))) of
      Left e -> throwIO (bridgeError "engine" (T.pack e))
      Right r -> pure r
    value <- action request
    pure (object ["ok" .= True, "value" .= value])
  let response = case outcome of
        Right value -> value
        Left (e :: SomeException) ->
          let err = case fromException e of
                Just bridgeErr -> bridgeErr
                Nothing -> bridgeError "evaluation" (T.pack (show e))
          in errorEnvelope err
  pure (toJSString (T.unpack (TE.decodeUtf8 (LBS.toStrict (encode response)))))

errorEnvelope :: BridgeError -> Value
errorEnvelope BridgeError {..} = object
  [ "ok" .= False
  , "error" .= object
      [ "kind" .= errorKind
      , "message" .= errorMessage
      , "source" .= errorSource
      ]
  ]

normalizeRequest
  :: JSVal -> Text -> M.Map Text Text -> Text -> IO (Expr Void Void)
normalizeRequest resolver sourcePath variables source = do
  parsed <- case Parser.exprFromText (T.unpack sourcePath) source of
    Left e -> throwIO (bridgeError "parse" (T.pack (show e)))
    Right e -> pure e
  resolved <- resolveExpr resolver variables mempty sourcePath parsed
  stripped <- case stripEmbeds resolved of
    Left e -> throwIO e
    Right e -> pure e
  case TypeCheck.typeOf stripped of
    Left e -> throwIO (bridgeError "typecheck" (renderTypeError e))
    Right _ -> pure (Core.normalize stripped)

renderTypeError :: TypeCheck.TypeError Void Void -> Text
renderTypeError = T.pack . show

stripEmbeds :: Expr Src Import -> Either BridgeError (Expr Void Void)
stripEmbeds expr = Core.denote <$> go expr
  where
    go :: Expr Src Import -> Either BridgeError (Expr Src Void)
    go = Core.subExpressionsWith rejectEmbed go

    rejectEmbed _ = Left (bridgeError "import" "Unresolved import in expression")

resolveExpr
  :: JSVal
  -> M.Map Text Text
  -> [Text]
  -> Text
  -> Expr Src Import
  -> IO (Expr Src Import)
resolveExpr resolver variables stack base =
  Core.subExpressionsWith
    (resolveImport resolver variables stack base)
    (resolveExpr resolver variables stack base)

resolveImport
  :: JSVal -> M.Map Text Text -> [Text] -> Text -> Import -> IO (Expr Src Import)
resolveImport resolver variables stack base (Import hashed mode) = do
  let ImportHashed mHash importType = hashed
      specifier = Core.pretty importType
      hashCode = fmap (\h -> "sha256:" <> T.pack (show h)) mHash
  when (specifier `elem` stack) $
    throwIO (bridgeError "import" ("Cyclic import: " <> specifier))
  content <- case importType of
    Env name -> case M.lookup name variables of
      Just text -> pure (text, name)
      Nothing -> throwIO (bridgeError "import" ("Missing environment variable: " <> name))
    _ -> do
      let importBase
            | "://" `T.isInfixOf` base = base
            | otherwise = T.pack (takeDirectory (T.unpack base))
          request = object $
            [ "specifier" .= specifier
            , "baseDirectory" .= importBase
            , "expectedHash" .= hashCode
            ]
      response <- jsResolveImport resolver (toJSString (T.unpack (jsonText request)))
      resolved <- case eitherDecodeStrict (TE.encodeUtf8 (T.pack (fromJSString response))) of
        Left e -> throwIO (bridgeError "import" (T.pack e))
        Right r -> pure r
      unless (resolverOk resolved) $
        throwIO (BridgeError (resolverErrorKind resolved) (resolverErrorMessage resolved) Nothing)
      pure (resolverText resolved, resolverSource resolved)

  let (text, label) = content
      childBase = baseFor label
  parsed <- case Parser.exprFromText (T.unpack label) text of
    Left e -> throwIO (bridgeError "parse" (T.pack (show e)))
    Right e -> pure e
  resolved <- resolveExpr resolver variables (specifier : stack) childBase parsed
  stripped <- case stripEmbeds resolved of
    Left e -> throwIO e
    Right e -> pure e
  case mode of
    RawText -> pure (TextLit (Chunks [] text))
    RawBytes -> pure (BytesLit (TE.encodeUtf8 text))
    Location -> throwIO (bridgeError "unsupported" ("Location imports are not supported: " <> specifier))
    Code -> do
      case TypeCheck.typeOf stripped of
        Left e -> throwIO (bridgeError "typecheck" (renderTypeError e))
        Right _ -> pure ()
      let normalized = Core.normalize stripped
      case hashCode of
        Nothing -> pure ()
        Just expected -> do
          let actual = hashExpressionToCode normalized
          unless (expected == actual) $
            throwIO (bridgeError "integrity" ("Import hash mismatch: " <> specifier))
      pure (Core.renote (fmap absurd normalized))

baseFor :: Text -> Text
baseFor label
  | "://" `T.isInfixOf` label = label
  | T.null label = "."
  | otherwise = T.pack (takeDirectory (T.unpack label))

jsonText :: Value -> Text
jsonText = TE.decodeUtf8 . LBS.toStrict . encode

-- | Convert a normalized, closed Dhall expression to a JSON value.  This is a
-- small local equivalent of dhall-json that avoids its older aeson bound.
dhallToValue :: Expr Void Void -> Either Text Value
dhallToValue expr = case Core.normalize expr of
  BoolLit b -> Right (toJSON b)
  NaturalLit n -> Right (toJSON (fromIntegral n :: Integer))
  IntegerLit n -> Right (toJSON n)
  DoubleLit (DhallDouble d) -> Right (toJSON d)
  TextLit (Chunks [] text) -> Right (toJSON text)
  ListLit _ elements -> toJSON <$> traverse dhallToValue (toList elements)
  Some value -> dhallToValue value
  App None _ -> Right Null
  RecordLit fields -> object <$> traverse
    (\(name, field) -> (Key.fromText name .=) <$> dhallToValue (recordFieldValue field))
    (DhallMap.toList fields)
  App (Field (Union _) (FieldSelection _ name _)) value -> do
    converted <- dhallToValue value
    pure (object [Key.fromText name .= converted])
  Field (Union _) (FieldSelection _ name _) -> Right (toJSON name)
  BytesLit bytes -> Right (toJSON (map fromIntegral (BS.unpack bytes) :: [Integer]))
  other -> Left ("Cannot convert Dhall expression to JSON: " <> Core.pretty other)

-- | Encode a normalized value as CBOR using the same canonical rules the TS
-- renderer used: maps are sorted by key and integral numbers use CBOR integer
-- majors while fractional numbers use float64.
cborEncoding :: Value -> Encoding
cborEncoding value = case value of
  Null -> encodeNull
  Aeson.Bool b -> encodeBool b
  Number n -> case floatingOrInteger n of
    Right integer -> encodeInteger integer
    Left double -> encodeDouble double
  String text -> encodeString text
  Array values ->
    encodeListLen (fromIntegral (length values)) <> mconcat (map cborEncoding (toList values))
  Object fields ->
    let sorted = sortOn (Key.toText . fst) (KeyMap.toList fields)
    in encodeMapLen (fromIntegral (length sorted))
       <> mconcat [encodeString (Key.toText key) <> cborEncoding item | (key, item) <- sorted]

toCborHex :: Value -> Text
toCborHex = T.pack . concatMap hexByte . BS.unpack . CBOR.toStrictByteString . cborEncoding
  where
    hexByte :: Word8 -> String
    hexByte byte =
      let digits = showHex byte ""
      in if length digits == 1 then '0' : digits else digits

unknownType :: Expr Void Void -> BridgeError
unknownType expr = bridgeError
  "unsupported"
  ("Cannot describe Dhall type: " <> Core.pretty expr)

describeSchema :: Expr Void Void -> IO Value
describeSchema expr = case Core.normalize expr of
  Core.Bool -> pure (primitive "Bool")
  Bytes -> pure (primitive "Bytes")
  Double -> pure (primitive "Double")
  Integer -> pure (primitive "Integer")
  Natural -> pure (primitive "Natural")
  Text -> pure (primitive "Text")
  App List element -> do
    elementSchema <- describeSchema element
    pure $ case mapSchema element of
      Just valueSchema -> object
        [ "kind" .= ("map" :: Text)
        , "key" .= primitive "Text"
        , "value" .= valueSchema
        ]
      Nothing -> object ["kind" .= ("list" :: Text), "element" .= elementSchema]
  App Optional element -> do
    elementSchema <- describeSchema element
    pure (object ["kind" .= ("optional" :: Text), "element" .= elementSchema])
  Record fields -> do
    rendered <- traverse
      (\(name, field) -> (Key.fromText name .=) <$> describeSchema (recordFieldValue field))
      (DhallMap.toList fields)
    pure (object ["kind" .= ("record" :: Text), "fields" .= object rendered])
  Union alternatives -> do
    rendered <- traverse describeAlternative (DhallMap.toList alternatives)
    pure (object ["kind" .= ("union" :: Text), "alternatives" .= object rendered])
  Pi _ _ argument result -> do
    argumentSchema <- describeSchema argument
    resultSchema <- describeSchema result
    pure (object
      [ "kind" .= ("function" :: Text)
      , "argument" .= argumentSchema
      , "result" .= resultSchema
      ])
  other -> throwIO (unknownType other)
  where
    describeAlternative (name, Nothing) = pure (Key.fromText name .= Null)
    describeAlternative (name, Just value) = do
      schema <- describeSchema value
      pure (Key.fromText name .= schema)

mapSchema :: Expr Void Void -> Maybe Value
mapSchema (Record fields) =
  case DhallMap.toList fields of
    [(keyName, keyField), (valueName, valueField)]
      | keyName == "mapKey"
      , valueName == "mapValue"
      , Core.normalize (recordFieldValue keyField) == (Text :: Expr Void Void) ->
          Just (describeSchemaPure (recordFieldValue valueField))
    _ -> Nothing
mapSchema _ = Nothing

describeSchemaPure :: Expr Void Void -> Value
describeSchemaPure expr = case Core.normalize expr of
  Core.Bool -> primitive "Bool"
  Bytes -> primitive "Bytes"
  Double -> primitive "Double"
  Integer -> primitive "Integer"
  Natural -> primitive "Natural"
  Text -> primitive "Text"
  App List element -> object ["kind" .= ("list" :: Text), "element" .= describeSchemaPure element]
  App Optional element -> object ["kind" .= ("optional" :: Text), "element" .= describeSchemaPure element]
  Record fields -> object
    ["kind" .= ("record" :: Text), "fields" .= object
      [ Key.fromText name .= describeSchemaPure (recordFieldValue field)
      | (name, field) <- DhallMap.toList fields
      ]]
  Union alternatives -> object
    ["kind" .= ("union" :: Text), "alternatives" .= object
      [ Key.fromText name .= maybe Null describeSchemaPure value
      | (name, value) <- DhallMap.toList alternatives
      ]]
  other -> object ["kind" .= ("unsupported" :: Text), "name" .= Core.pretty other]

primitive :: Text -> Value
primitive name = object ["kind" .= ("primitive" :: Text), "name" .= name]
